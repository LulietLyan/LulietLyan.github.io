---
title: Go 的 GMP 调度模型
description: 解释 Goroutine、操作系统线程和逻辑处理器如何协作，以及运行队列、工作窃取、网络轮询、系统调用和抢占调度。
date: 2026-09-03
order: 11
tags:
  - Go
  - GMP
  - Scheduler
  - Concurrency
---

## 省流

> GMP 是 Go Runtime 把大量 Goroutine 调度到少量操作系统线程上的模型。G 是 Goroutine，保存执行栈、指令位置和调度状态；M 是 Machine，对应 OS Thread，真正由操作系统调度；P 是 Processor，代表执行 Go 代码所需的逻辑处理器和本地资源，例如本地运行队列、内存分配缓存。P 的数量由 `GOMAXPROCS` 控制，因此它决定同一时刻最多有多少个线程并行执行普通 Go 代码。
>
> 一个 M 必须拿到 P 才能执行 G。新建的 G 通常先进入当前 P 的本地运行队列；M 执行完或阻塞当前 G 后，继续从本地队列、全局队列、网络轮询器或其他 P 获取任务。空闲 P 没有工作时会随机选择其他 P，窃取一部分可运行 G，这叫 Work Stealing，用来均衡负载。
>
> Goroutine 因 Channel、Mutex 等运行时同步原语阻塞时，只挂起 G，M 和 P 可以继续执行别的 G；网络 I/O 通常交给 Netpoller，等待就绪后再把 G 放回运行队列。若 M 陷入可能阻塞的系统调用，Runtime 会尽量把它的 P 转交给其他 M，避免一个系统调用占住并行执行配额。系统调用返回的 M 需要重新获取 P，否则把 G 放回可运行队列。
>
> Go 调度是协作与抢占结合。函数调用、安全点、阻塞操作会提供调度机会，Runtime 也支持异步抢占，避免长时间计算的 G 永久占用 P。GMP 的价值是让 Goroutine 创建和切换比直接使用大量 OS Thread 更轻，同时通过本地队列、工作窃取、Netpoll 和系统调用接管提高多核与 I/O 利用率。

## G、M、P 分别是什么？

| 组件 | 含义 | 保存的关键信息 |
| --- | --- | --- |
| G | Goroutine，待执行的用户任务 | 动态栈、程序计数位置、状态、等待原因、关联的 M 等 |
| M | Machine，操作系统线程 | 当前 G、调度栈 `g0`、绑定的 P、线程本地状态等 |
| P | Processor，执行 Go 代码的资格和资源 | 本地运行队列、`runnext`、`mcache`、Timer 等 |

三者关系可以概括为：

```text
                 P0 local run queue: G2 G3 G4
                           |
                           v
OS Scheduler -> M0 <-----> P0 ----executes----> G1

Global run queue: G5 G6 ...
Netpoll ready:    G7 ...
```

G 不是线程，P 也不是 CPU 核。操作系统只认识 M；P 是 Go Runtime 的逻辑资源。M 绑定 P 后，才有资格执行普通 Go 用户代码。

## 为什么不能只有 G 和 M？

早期只做 M:N 映射时，全局运行队列和全局资源会产生严重锁竞争，线程之间还要频繁传递缓存状态。P 把与执行相关的资源分片：

- 每个 P 有本地运行队列，大多数调度不碰全局锁。
- 每个 P 有 `mcache`，小对象分配常走本地快速路径。
- Timer、GC Worker 等工作可以围绕 P 分散处理。
- `GOMAXPROCS` 直接限制执行 Go 代码的并行度，而不需要限制阻塞在系统调用中的 M 数量。

因此 P 不只是“一个队列”，而是一组运行 Go 代码所需的上下文和本地资源。

## `GOMAXPROCS` 控制什么？

Runtime 中恰好有 `GOMAXPROCS` 个 P。它控制同一时刻能够并行执行 Go 代码的最大 P 数量，通常按进程可用 CPU 配额设置。

它不表示：

- Goroutine 的最大数量；G 可以远多于 P。
- M 的最大数量；阻塞系统调用和 cgo 可能需要额外 M。
- 程序一定能达到的并行度；任务不足、锁竞争或 CPU 配额都会限制实际并行。

并发是多个任务在时间上推进，并行是多个任务在同一时刻由不同核心执行。`GOMAXPROCS=1` 仍可以并发调度很多 G，只是普通 Go 代码不能多核并行执行。

## 一个 Goroutine 如何开始运行？

执行 `go f()` 时，Runtime 大致会：

1. 创建或复用一个 G，初始化入口函数、参数和很小的初始栈。
2. 把 G 标记为 Runnable。
3. 优先放入当前 P 的 `runnext` 或本地运行队列。
4. 如果本地队列已满，把一批任务转移到全局运行队列。
5. 必要时唤醒或创建 M，让空闲 P 开始执行任务。

`runnext` 是一个优先槽，适合让刚唤醒、与当前任务相关的 G 尽快执行，并可能继承当前时间片。Runtime 不保证业务层面的严格 FIFO、公平顺序，代码不能依赖 Goroutine 的具体调度先后。

## M 从哪里寻找可运行的 G？

真实的 `findRunnable` 会综合很多来源，面试可以概括为：

1. 当前 P 的 `runnext` 和本地运行队列。
2. 定期检查全局运行队列，避免全局任务饥饿。
3. 已到期的 Timer、GC Worker 等 Runtime 工作。
4. Netpoller 中已经 I/O Ready 的 G。
5. 从其他 P 的本地队列窃取任务。
6. 实在没有工作就让 M 自旋一段时间或休眠，等待唤醒。

顺序和启发式会随版本变化，不应把某份源码里的固定检查次数当成稳定 API。核心目标是在调度延迟、全局公平、锁竞争和空转 CPU 之间平衡。

## Work Stealing 怎么做？

如果 P0 的队列空了，但 P1 堆积很多 G，P0 对应的 M 不应该休眠。它会随机选择其他 P，尝试窃取其一部分 Runnable G，通常还会检查对方的 Timer。

```text
P0: []                 P0: [G5 G6]
          steal  =>
P1: [G1 G2 G3 G4 G5 G6]   P1: [G1 G2 G3 G4]
```

批量窃取比每次只抢一个更能摊薄同步成本；随机选择受害者可以降低所有空闲 P 同时争抢一个队列的概率。

工作窃取解决的是运行队列负载不均，不会解决业务锁竞争。如果所有 G 都在等同一把 Mutex，再均匀地分到不同 P 也没有吞吐收益。

## Goroutine 阻塞时发生什么？

### Channel、Mutex、Cond 等 Runtime 可感知的阻塞

当前 G 会通过 `gopark` 进入 Waiting 状态，登记到对应等待队列。M 不需要阻塞，仍持有 P 并执行其他 Runnable G。条件满足后，另一个 G 或 Runtime 调用 `goready`，把它重新变为 Runnable。

```text
G1 等 Channel -> park G1
M + P         -> 立即运行 G2
Channel 就绪  -> G1 回到运行队列
```

### 网络 I/O

Go 网络库把 Socket 交给平台 Netpoller，例如 Linux 的 epoll、BSD/macOS 的 kqueue 或 Windows 的 IOCP。等待网络的 G 被挂起，M 可以执行其他任务；事件就绪后，Netpoller 把 G 重新注入运行队列。

这也是大量网络 Goroutine 不需要一一占住 OS Thread 的关键。若调用的是 Runtime 无法接管的阻塞操作，行为可能不同。

### 阻塞系统调用

M 进入系统调用前会标记状态。若调用持续阻塞，Runtime 可以把 P 从这个 M 上摘下，交给另一个 M：

```text
M1 + P0 执行 G1
G1 进入阻塞 syscall
M1 被 OS 阻塞，P0 handoff 给 M2
M2 + P0 继续执行其他 G
```

系统调用返回后，M1 尝试获得一个空闲 P；拿不到时，把原 G 放回运行队列，M1 进入空闲状态。这样阻塞线程数量可以超过 P 数量，但并行执行 Go 代码的 M 仍受 P 限制。

## Go 如何抢占长时间运行的 G？

如果只有协作式调度，一个不调用函数、不阻塞的计算循环可能长期占住 P。现代 Go 同时利用：

- 函数序言和安全点检查。
- Channel、锁、系统调用、`runtime.Gosched()` 等主动调度点。
- Runtime Monitor 发现长时间运行的 G 后发起抢占请求。
- 支持平台上的异步抢占信号，让没有普通函数调用的循环也能被打断到安全点。

抢占不等于实时调度保证。Go Scheduler 不承诺某个 G 在固定毫秒内一定运行，也不提供硬实时优先级。

## `sysmon` 做什么？

`sysmon` 是不需要绑定 P 的 Runtime 监控线程，负责周期性检查系统状态，包括：

- 处理长时间系统调用后的 P Handoff。
- 触发对长时间运行 G 的抢占。
- 协助 Netpoll、Timer 和 GC 等运行时工作。
- 在调度和内存管理的异常状态下推进系统。

它是调度器的后台保障，但不能把所有 Runtime 后台工作都统称为 `sysmon`。

## Goroutine 为什么比线程轻？

- 初始用户栈很小，当前 Runtime 文档示例约为 2 KiB，并能动态增长、收缩。
- 创建、阻塞和切换主要在用户态 Runtime 完成，不必每次进入内核调度器。
- 网络阻塞可以停 G 而不占住 M。
- 每个 P 的本地队列和内存缓存降低全局锁竞争。

“轻量”不等于没有成本。每个 G 仍需要描述符、栈和引用对象；创建百万个永久阻塞的 Goroutine 会消耗大量内存，并扩大 GC 根扫描和排障成本。

## 常见调度问题如何排查？

- `go tool pprof` 的 Goroutine Profile：找数量异常和共同阻塞栈。
- Block Profile：找 Channel、Mutex 等阻塞时间。
- Mutex Profile：找锁竞争热点。
- `go tool trace`：观察 G 的创建、运行、阻塞、Syscall 与 P 的使用情况。
- `GODEBUG=schedtrace=1000,scheddetail=1`：周期输出调度器快照，适合短期诊断。

重点关注 Runnable 队列持续堆积、Goroutine 数只增不减、系统调用线程过多、P 长时间空闲或 Mutex 等待占比异常。

## 扩展问题

### P 和 CPU 核是一一对应的吗？

不是。P 是 Runtime 的逻辑处理器，数量由 `GOMAXPROCS` 决定，操作系统再把 M 调度到真实 CPU 上。常见配置会接近可用 CPU 数，但不存在固定绑定关系。

### M 没有 P 能做什么？

它不能执行普通 Go 用户代码，但可以阻塞在系统调用中、执行某些不需要 P 的 Runtime 工作，或者处于空闲状态。要恢复执行 G，必须先拿到 P。

### Goroutine 阻塞一定不会阻塞线程吗？

不一定。Runtime 能识别的 Channel、锁和网络轮询通常只挂起 G；普通阻塞系统调用会阻塞 M，但 P 可被转交。cgo、外部库以及 Runtime 无法集成的调用还可能长期占用线程。

### `runtime.Gosched()` 和休眠有什么区别？

`Gosched()` 让出当前执行权，但当前 G 仍是 Runnable，之后可以继续被调度；`time.Sleep` 会让 G 等到 Timer 到期前保持 Waiting，不参与普通运行队列竞争。

## 参考资料

- [Go runtime HACKING: Gs, Ms, Ps](https://go.dev/src/runtime/HACKING)
- [Go scheduler source](https://go.dev/src/runtime/proc.go)
- [Go diagnostics](https://go.dev/doc/diagnostics)
- [The Go Memory Model](https://go.dev/ref/mem)
