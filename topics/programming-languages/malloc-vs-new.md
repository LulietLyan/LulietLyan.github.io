---
title: malloc 和 new 有什么区别？
description: 从语言归属、构造析构、失败语义、可重载性与配对释放方式对比 C 的 malloc 与 C++ 的 new。
date: 2026-09-09
order: 11
tags:
  - C
  - C++
  - malloc
  - new
  - Memory Management
---

## 省流

> `malloc` 是 C 库函数，按字节数申请未初始化的内存，成功返回 `void*`，失败返回 `NULL`；释放用 `free`。`new` 是 C++ 运算符，分配内存并**调用构造函数**，返回带类型的指针；释放用 `delete`/`delete[]`，并**调用析构函数**。
>
> 二者不是简单别名。`new` 的分配失败在现代 C++ 默认抛 `std::bad_alloc`（可用 `nothrow` 版本改为返回空指针）；`malloc` 不调用构造/析构，对非平凡 C++ 对象不够用。`new`/`delete` 可被类或全局重载，`malloc`/`free` 是库函数。必须配对使用：`malloc` 配 `free`，`new` 配 `delete`，`new[]` 配 `delete[]`，混用属于未定义行为。
>
> C++ 中管理对象生命周期应优先 `new`/`delete` 或更好的智能指针与容器；只有对接 C API、按字节操作裸内存等场景才使用 `malloc`。

## 对比表

| 维度 | malloc / free | new / delete |
| --- | --- | --- |
| 所属 | C 库函数，C++ 也可调用 | C++ 运算符 |
| 参数 | 字节大小 | 类型；数组形式还含元素个数 |
| 返回 | `void*`，需自行转换 | 类型指针 |
| 初始化 | 不初始化（内容不确定） | 分配后调用构造函数 |
| 释放时 | 只归还内存 | 先析构，再释放内存 |
| 失败 | 返回 `NULL` | 默认抛异常 |
| 扩展 | 一般不谈“重载 malloc” | 可重载 `operator new` 等 |

## 对象语义是最大差别

```c
int *p = (int *)malloc(sizeof(int));  /* 仅得到一块原始内存 */
```

```cpp
int *p = new int(42);     // 分配并初始化
std::string *s = new std::string("x"); // 调用 string 构造函数
delete s;                 // 先析构再释放
```

若对 C++ 对象只用 `malloc`/`free`，会跳过构造与析构，轻则资源泄漏，重则未定义行为。

## 数组形式

- C：`malloc(n * sizeof(T))`，自己管理长度。
- C++：`new T[n]` 与 `delete[]` 配对，否则可能只析构一个元素或破坏分配器元数据。

## 底层关系（常被追问）

许多 C++ 实现里，默认的全局 `operator new` 最终仍可能通过类似 `malloc` 的路径向堆要内存，但这是实现细节。语言层面仍应按 `new`/`delete` 的语义理解：它多了构造、析构、类型与异常（或 nothrow）约定。

## 使用建议

- 写 C：`malloc`/`calloc`/`realloc` + `free`。
- 写 C++：优先标准库容器与智能指针；必须手动时用 `new`/`delete`。
- 与 C 库交互、自己做内存池时，可以在池内部使用 `malloc` 或 `operator new` 分配原始字节，再对对象做 placement new；那是更进阶的用法，面试说清“原始内存”和“对象生命周期”两层即可。
