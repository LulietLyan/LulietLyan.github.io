---
title: Redis 如何用跳表实现 ZSet？
description: 从节点层级、查找与插入路径、跨度排名、字典辅助索引和 Listpack 编码解释 Redis Sorted Set 的实现。
date: 2026-09-03
order: 8
tags:
  - Redis
  - Sorted Set
  - Skiplist
  - Data Structure
---

## 省流

> ZSet 要同时做到：member 唯一、按 `(score, member)` 有序、按 member 查 score、按分数/排名做范围查询。普通跳表编码用两套结构一起满足这些能力——跳表按 `(score, member)` 排好序，字典按 member 建索引。
>
> 跳表如何工作：最底层用链表组织全部节点，上层是随机抽取的稀疏索引。查找从最高层向右；下一步会越过目标就下降一层，期望 O(log N)。插入时先沿各层记下前驱 `update[i]`，再随机定层高，改写邻接的 `forward`，并同步更新字典。
>
> Redis 给跳表加了实现细节：每层 `forward` 带 `span`（这一跳跨过几个底层节点），查找时累加 span 就能算 `ZRANK`，按排名定位也能跳过整段；最底层还有 `backward`，方便反向遍历。范围查询则是先 O(log N) 落到起点，再沿第 1 层顺序吐出 M 个元素。
>
> 字典节省开销：只知 member 时无法沿有序路径搜索，所以 `ZSCORE`、判重、改 score 前定位都靠字典平均 O(1)。元素很少时 Redis 会先用 `listpack` 省指针开销，超阈值再切到跳表；选跳表而不是红黑树，主要是范围遍历自然、加 span 就能做排名、实现比旋转平衡更直接。

## ZSet 要同时满足哪些能力？

ZSet 的语义不是普通有序数组，它同时需要：

- member 唯一；重复 `ZADD` 是更新 score，而不是插入第二份 member。
- 按 score 排序；score 相同时按 member 字典序排序。
- 按 member 快速查 score。
- 按 score、字典序或排名做范围查询。
- 插入、删除、改分数后仍保持有序。

单一结构很难同时把这些操作都做到理想复杂度，所以 Redis 的普通 ZSet 编码组合了字典和跳表。

```text
zset
  ├─ dict：member -> skiplist node/score
  └─ zsl：header -> 按 (score, member) 排序的节点
```

## 跳表长什么样？

```text
Level 3: head --------------------------> D
Level 2: head ----------> B ------------> D
Level 1: head -> A -----> B -> C -------> D -> E
                10        20   20          35   50
```

最底层有全部元素；越高层元素越少，形成快速索引。Redis 当前源码的最大层数是 32，晋升概率是 1/4，因此节点拥有至少一层，出现更高层的概率按几何分布递减。

每个节点的关键信息包括：

```text
score
member
backward
level[]:
  forward
  span
```

`forward` 指向该层下一个节点，`backward` 只需服务最底层的反向遍历。`span` 不是字节数，而是这一跳跨过的底层节点数量。

## 如何查找？

以查找目标 `(score=35, member=D)` 为例：

1. 从 Header 的当前最高层开始。
2. 如果下一个节点小于目标，就向右移动。
3. 如果下一个节点大于等于目标，下降一层。
4. 到第 1 层后即可确定目标或它的插入位置。

比较规则是：

```text
a 在 b 前面，当且仅当：
a.score < b.score
或者 a.score == b.score 且 a.member < b.member（字典序）
```

这种搜索与平衡树从根向下类似，期望复杂度是 O(log N)，最坏情况仍可能退化为 O(N)。随机层高让跳表不需要维护旋转和严格平衡。

## `ZADD` 如何插入新成员？

插入前再搜索过程中会维护两个数组：

- `update[i]`：第 i 层中，新节点前面的最后一个节点。
- `rank[i]`：到达这个前驱时，已经跨过的底层节点数。

然后执行：

1. 从高层向下查找，填充 `update` 和 `rank`。
2. 随机产生新节点层数。
3. 对新节点拥有的每一层，修改前驱和后继的 `forward`。
4. 根据 `rank` 修正新节点和前驱的 `span`。
5. 更高但未插入节点的层，其指针不变，但 span 要加一。
6. 维护最底层的 `backward`、跳表尾指针和长度。
7. 同步把 member 索引写入字典。

整个命令在 Redis 核心执行线程中完成，其他命令不会观察到“字典已更新但跳表还没更新”的中间状态。

## `span` 如何支持排名？

假设搜索时在某层从 A 一步跳到 D，`span=3`，说明这一步跨过了 3 个底层节点。查找 member 时，把每次向右移动的 span 累加，就得到了它的 1-based 位置，再换算为 Redis 返回的 0-based Rank。

反过来查找第 K 名时，只要下一跳累计 span 不超过目标就向右，否则下降一层。这样无需从链表头逐个数，`ZRANK` 和按 Rank 定位都能保持期望 O(log N)。

## 更新 score 时怎么办？

字典先帮助 O(1) 找到 member。若新 score 不破坏当前节点与前后节点的顺序，部分实现路径可以原地更新；否则从跳表删除旧 `(score, member)`，再按新 score 插入，字典也同步指向新状态。

`ZINCRBY` 本质上也要执行这套重新定位逻辑。member 没变不代表节点在有序结构中的位置不变。

## 范围查询为什么快？

`ZRANGE ... BYSCORE` 先用跳表 O(log N) 找到范围的第一个节点，然后沿第 1 层顺序遍历 M 个结果，所以复杂度通常是 O(log N + M)。

范围很大时，M 才是主要成本。即使起点定位是 O(log N)，一次返回几十万元素仍会占用 CPU、网络和客户端内存。

## 为什么还需要字典？

跳表按 `(score, member)` 排序。如果只知道 member、不知道 score，就无法沿有序路径判断该向哪里走，只能扫描。字典提供：

- `ZSCORE member`：平均 O(1)。
- 判断 member 是否已存在：平均 O(1)。
- 更新 score 前快速定位旧节点或旧分数。
- 强制 member 唯一。

代价是同一份逻辑数据要维护两套索引，增加内存占用。Redis 会尽量复用成员数据，而不是复制两份完整字符串。

## 为什么不用红黑树？

跳表和红黑树的查找、插入、删除平均或保证复杂度都可达到 O(log N)，选择更多是工程取舍：

- 跳表插入删除主要修改邻接指针，不需要旋转，代码和范围迭代较直接。
- 最底层天然是有序链表，找到起点后连续遍历范围很方便。
- 增加 span 后可直接支持 Rank。
- 随机化带来的是期望复杂度，理论最坏情况不如严格平衡树。
- 每个节点有多个前向指针，内存也不是无成本的。

所以答案不应该是“跳表一定比红黑树快”，而是它非常贴合 Redis 的范围遍历、排名和实现复杂度需求。

## 小 ZSet 为什么不用跳表？

元素很少时，O(N) 扫描的 N 很小，而跳表节点、字典桶和大量指针的固定开销很高。`listpack` 连续存储 member 和 score，缓存局部性和内存占用更好。

超过 `zset-max-listpack-entries` 或 `zset-max-listpack-value` 等配置阈值后，Redis 再转换到跳表编码。具体默认值和转换细节可能随版本变化，应以部署版本配置为准。

## 操作复杂度

| 操作 | 跳表编码下的典型复杂度 | 原因 |
| --- | --- | --- |
| `ZSCORE` | 平均 O(1) | 查字典 |
| `ZADD` / `ZREM` | O(log N) | 跳表定位并修改 |
| `ZRANK` | O(log N) | 跳表查找并累计 span |
| `ZRANGE` by rank/score | O(log N + M) | 定位起点后顺序返回 M 个元素 |
| `ZPOPMIN` / `ZPOPMAX` | O(log N * M) | 删除 M 个节点并维护索引 |

## 扩展问题

### 跳表能保证 O(log N) 吗？

它保证的是随机层高下的期望 O(log N)，最坏可以退化为 O(N)。Redis 使用固定最大层数和概率分布，使实际性能足够稳定。

### 相同 score 怎么排序？

按 member 的二进制字典序排序。因此 `(score, member)` 可以唯一确定跳表中的位置，范围和排名结果也是确定的。

### ZSet 一定使用跳表吗？

不一定。较小且元素较短时使用 `listpack`；达到配置条件后才转换为普通的跳表编码。用 `OBJECT ENCODING key` 可以观察实际编码。

## 参考资料

- [Redis sorted sets](https://redis.io/docs/latest/develop/data-types/sorted-sets/)
- [Redis object encodings](https://redis.io/docs/latest/commands/object-encoding/)
- [Redis ZSet source](https://github.com/redis/redis/blob/unstable/src/t_zset.c)
- [Redis object definitions](https://github.com/redis/redis/blob/unstable/src/server.h)
