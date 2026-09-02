---
title: Redis 的数据类型与底层数据结构
description: 区分 Redis 对外数据类型和内部编码，梳理 String、Hash、List、Set、ZSet、Stream 等结构的实现、复杂度与使用场景。
date: 2026-09-03
order: 7
tags:
  - Redis
  - Data Structure
  - Encoding
  - Interview
---

## 省流

> 回答 Redis 数据结构时，我会区分“对外数据类型”和“底层编码”。常用数据类型有 String、Hash、List、Set、Sorted Set 和 Stream；Bitmap、Bitfield、HyperLogLog、GEO 等则建立在基础结构或专用编码之上。
>
> Redis 不会让一种数据类型永远绑定一种实现，而是根据元素数量、元素大小和内容选择更省内存的编码。比如 String 可以是整数、`embstr` 或普通 SDS；List 主要使用 `listpack` 或由多个紧凑节点组成的 `quicklist`；Hash 使用 `listpack` 或哈希表；Set 可使用整数集合、`listpack` 或哈希表；ZSet 较小时使用 `listpack`，较大时同时使用哈希表和跳表；Stream 主要用 Radix Tree 组织装有多条记录的 `listpack`。
>
> 这种自适应编码是在时间和空间之间取舍：小集合用连续紧凑结构减少指针和对象头，大集合转换成哈希表、Quicklist 或跳表来保证操作复杂度。面试中不能只说“五大类型”，还要说明常用命令、典型复杂度以及为什么会切换编码。

## 先分清三层概念

```text
命令语义       String / Hash / List / Set / ZSet / Stream
                   |
Redis 对象层    type + encoding + ptr + 引用/淘汰元数据
                   |
底层结构       SDS / dict / listpack / quicklist / intset / skiplist / rax
```

同一个 Redis Key 指向一个对象，对象记录逻辑类型、当前编码和底层数据指针。客户端看到的是稳定的命令语义，Redis 可以在内部转换编码。

可以用下面的命令观察某个 Key 当前采用的编码：

```text
OBJECT ENCODING key
```

编码阈值可通过配置调整，而且会随 Redis 版本演进。例如旧资料中的 `ziplist` 在 Redis 7.0 以后应更多表述为 `listpack`；面试时最好先说明版本背景。

## 核心数据类型

| 数据类型 | 主要内部编码 | 典型能力 | 常见复杂度 |
| --- | --- | --- | --- |
| String | `int`、`embstr`、`raw`，内容通常由 SDS 承载 | 缓存、计数器、分布式锁令牌、Bitmap | `GET`/`SET`/`INCR` 通常 O(1) |
| Hash | `listpack`、`hashtable` | 对象字段、配置项、稀疏记录 | 单字段读写平均 O(1) |
| List | `listpack`、`quicklist` | 队列、栈、双端列表 | 两端操作 O(1)，按下标访问 O(N) |
| Set | `intset`、`listpack`、`hashtable` | 去重、成员判断、交并差集 | 单元素增删查平均 O(1) |
| Sorted Set | `listpack`、`skiplist`（跳表 + 字典） | 排行榜、延迟任务、范围查询 | 增删和定位通常 O(log N) |
| Stream | `stream`（Radix Tree + listpack） | 追加日志、消费组、消息处理 | `XADD` 通常 O(1) |

复杂度只是入口成本。像 `LRANGE 0 -1`、`SMEMBERS`、`HGETALL`、大范围 `ZRANGE` 还要加上返回 M 个元素的 O(M)，可能阻塞 Redis 主线程和网络输出。

## String：字节序列，不只是字符串

Redis String 可以保存文本、序列化数据、整数和二进制内容。逻辑上它是二进制安全的字节序列，长度不是靠 `\0` 结束。

SDS 会记录长度和容量，因此获取长度通常是 O(1)，追加时也可以预分配空间，并能安全保存二进制数据。对象可能采用：

- `int`：内容可直接表示为整数时，指针位置可以直接承载整数值。
- `embstr`：短字符串的对象头和 SDS 一次连续分配，减少分配次数和碎片。
- `raw`：较长或被修改后的字符串使用独立 SDS。

Bitmap 和 Bitfield 本质上也是对 String 中二进制位的解释。一次设置很远的 Bit 可能让字符串立即扩展，应防止异常偏移导致大内存分配。

## Hash：紧凑小对象与哈希表

字段较少且字段和值都较小时，Hash 使用 `listpack` 连续存储 field-value，省去大量指针和哈希桶开销。超过配置阈值后转换为哈希表，换取平均 O(1) 的字段访问。

Hash 适合频繁读取对象的个别字段。如果永远整对象读写，直接存序列化 String 可能更紧凑；如果需要服务端字段级更新、计数或字段 TTL，则 Hash 更合适。

## List：Listpack 与 Quicklist

List 保证插入顺序，并支持头尾 O(1) 推入和弹出。较小列表可以直接用紧凑 `listpack`；增长后通常使用 `quicklist`。

Quicklist 不是“纯双向链表”，而是双向链表的每个节点再保存一段紧凑元素，节点内部通常是 listpack。它在两种极端之间折中：

- 每个元素一个链表节点：修改方便，但指针和分配开销大，缓存局部性差。
- 所有元素一个连续数组：内存紧凑，但中间修改可能搬移大量数据。

List 适合简单队列和双端队列，但需要可靠消费、ACK、重放和消费组时应优先考虑 Stream。

## Set：根据内容选择编码

Set 的语义是无序且元素唯一。成员都是整数且集合较小时可用 `intset`；较小的一般集合在较新 Redis 版本中还可使用 `listpack`；规模增大后使用哈希表。

`SISMEMBER`、`SADD`、`SREM` 在哈希表编码下平均 O(1)。交集、并集和差集需要遍历集合，不能因为单元素查找是 O(1) 就认为 `SINTER` 也是 O(1)。

## Sorted Set：字典与跳表各司其职

ZSet 的每个 member 唯一，并关联一个 `double` score，按 `(score, member)` 排序：score 不同按 score；score 相同按 member 字典序。

小 ZSet 使用连续紧凑的 `listpack`。规模增大后采用两套索引：

```text
dict：member -> score/节点       负责按 member 快速查找
skiplist：(score, member) 有序   负责范围、排名和顺序遍历
```

因此 `ZSCORE` 可平均 O(1)，而 `ZADD`、`ZRANK` 和范围起点定位通常为 O(log N)。两套结构必须在一次命令执行中同步更新，Redis 单线程命令执行模型保证其他命令不会看到中间状态。

## Stream：面向消息日志

Stream 是按 ID 排序的追加日志，记录由多个 field-value 组成，并内置消费组、Pending Entries List、ACK 等语义。底层使用 Radix Tree 索引装有多条紧凑记录的 listpack，避免每条消息都成为一组独立堆对象。

Stream 与 Pub/Sub 的区别是消息会保留，可以回放和确认；Pub/Sub 更像在线广播，订阅者离线时不会替它保存历史消息。

## 派生和专用结构

- **Bitmap / Bitfield**：基于 String 的位操作，适合签到、状态位和紧凑布尔集合。
- **HyperLogLog**：概率基数统计，使用固定上限附近的内存换取小误差，不能返回具体成员。
- **GEO**：经纬度被编码后存入 ZSet，利用分数范围缩小候选集，再计算实际距离。
- **Pub/Sub**：一种消息通信机制，不是可持久化的数据类型。
- **JSON、Bloom Filter、Time Series、Vector Set**：取决于 Redis 版本和扩展模块，不应与传统核心类型的内部编码混为一谈。

## 选型时看什么？

1. 是否需要唯一性：需要则看 Set 或 ZSet。
2. 是否需要顺序：插入顺序用 List/Stream，按分数排序用 ZSet。
3. 是否需要消费确认与重放：用 Stream，而不只是 List 或 Pub/Sub。
4. 是否只读写个别字段：Hash；总是整块读写则可比较 String。
5. 是否会一次返回大量元素：优先分页、`SCAN` 家族或限制范围。
6. 是否能接受近似结果：基数统计可以考虑 HyperLogLog。

## 扩展问题

### Redis 为什么要设计多种编码？

小集合中，哈希桶和指针的元数据可能比真实内容还大，连续编码更省内存、CPU Cache 局部性也更好；集合变大后，连续扫描和搬移成本上升，再切换到面向查询效率的结构。

### 编码转换是双向的吗？

不能笼统回答“都会自动转回”。不同类型和版本的收缩转换策略不同，有些历史实现只在增长时转换。应把编码看作实现细节，并以当前版本源码、配置和 `OBJECT ENCODING` 的实际结果为准。

### Redis 单线程为什么还需要哈希表和跳表？

单线程只意味着命令之间不并行修改核心数据，不代表算法复杂度不重要。O(N) 操作会独占事件循环；高效结构正是 Redis 保持低延迟的基础。

## 参考资料

- [Redis data types](https://redis.io/docs/latest/develop/data-types/)
- [Redis object encodings](https://redis.io/docs/latest/commands/object-encoding/)
- [Redis memory optimization](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/memory-optimization/)
- [Redis core object implementation](https://github.com/redis/redis/blob/unstable/src/object.c)
