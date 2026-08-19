# 规划范例（结构示范；领域与你的不同，学习的是形状，不是内容）

下面是一份被评审员判为 accept 的小型规划，领域是「操作系统：进程与调度」，以 OSTEP（Remzi & Andrea Arpaci-Dusseau, *Operating Systems: Three Easy Pieces*）第 4 到 10 章为骨架。它示范了一份好规划的几个特征：

1. 结构锚定在公认教材的章节上，notes 写明依据；不确定的节点标 uncertain。
2. 概念粒度：每个概念能用一段话定义、能被一道题检验；名称附英文术语。
3. 前置关系只写真正阻塞理解的依赖：没有「相关」，没有环。
4. 单元 2 到 5 个概念，按拓扑序；第一个单元足够具体，第一天就能上手。
5. 退出标准全部是「不看资料能做到什么」的可检验陈述，用动词开头（写出、画出、计算、解释为什么、辨析），不用「理解」「掌握」「了解」。
6. 练习与退出标准对应：每条退出标准至少有一个练习能产生证据。
7. 按 weekly_hours 估算，每个单元的阅读加练习控制在一到两周。

## 提案（bb_plan_propose 的参数）

```json
{
  "concepts": [
    { "id": "process-abstraction", "name": "进程抽象（Process）", "tier": "core", "prereqs": [] },
    { "id": "process-states", "name": "进程状态与转换（Process States）", "tier": "core", "prereqs": ["process-abstraction"] },
    { "id": "process-api", "name": "进程 API：fork/exec/wait（Process API）", "tier": "core", "prereqs": ["process-abstraction"] },
    { "id": "limited-direct-execution", "name": "受限直接执行（Limited Direct Execution）", "tier": "core", "prereqs": ["process-abstraction"] },
    { "id": "trap-and-mode", "name": "陷阱与特权模式（Trap, User/Kernel Mode）", "tier": "core", "prereqs": ["limited-direct-execution"] },
    { "id": "context-switch", "name": "上下文切换（Context Switch）", "tier": "core", "prereqs": ["limited-direct-execution", "process-states"] },
    { "id": "timer-interrupt", "name": "时钟中断与抢占（Timer Interrupt）", "tier": "core", "prereqs": ["trap-and-mode"] },
    { "id": "sched-metrics", "name": "调度指标：周转时间与响应时间（Turnaround, Response Time）", "tier": "core", "prereqs": ["process-states"] },
    { "id": "fifo-sjf-stcf", "name": "FIFO、SJF、STCF（Basic Scheduling Policies）", "tier": "core", "prereqs": ["sched-metrics"] },
    { "id": "round-robin", "name": "时间片轮转（Round Robin）", "tier": "core", "prereqs": ["sched-metrics", "timer-interrupt"] },
    { "id": "mlfq", "name": "多级反馈队列（MLFQ）", "tier": "core", "prereqs": ["round-robin", "fifo-sjf-stcf"] },
    { "id": "lottery-scheduling", "name": "彩票调度（Lottery Scheduling）", "tier": "branch", "prereqs": ["sched-metrics"] },
    { "id": "multiprocessor-sched", "name": "多处理器调度：缓存亲和与负载均衡（Multiprocessor Scheduling）", "tier": "branch", "prereqs": ["mlfq"], "uncertain": true }
  ],
  "units": [
    {
      "id": "u01",
      "title": "进程是什么：抽象、状态与 API",
      "concepts": ["process-abstraction", "process-states", "process-api"],
      "exercises": [
        "用 fork/exec/wait 写一个最小 shell：读一行命令、创建子进程执行、等待返回",
        "画出一个进程从创建到退出经历的状态图，标出每条边由什么事件触发"
      ],
      "exit_criteria": [
        "不看资料写出 fork 返回值在父子进程中的差异，并解释 exec 为什么不返回",
        "画出三态（运行、就绪、阻塞）转换图并说明每条边的触发事件",
        "解释为什么 wait 能回收子进程，不调用 wait 会发生什么"
      ]
    },
    {
      "id": "u02",
      "title": "CPU 如何被安全地共享：受限直接执行",
      "concepts": ["limited-direct-execution", "trap-and-mode", "context-switch", "timer-interrupt"],
      "exercises": [
        "按 OSTEP 第 6 章表 6.2 的格式，手写一次系统调用与一次时钟中断引发切换的完整时间线",
        "用 lmbench 或自写程序测量一次系统调用与一次上下文切换的开销，记录方法与数字"
      ],
      "exit_criteria": [
        "不看资料说明用户态程序为什么不能直接执行特权指令，以及 trap 如何进入内核",
        "写出上下文切换时必须保存与恢复的寄存器集合，并说明保存在哪里",
        "解释没有时钟中断时操作系统为什么可能失去控制"
      ]
    },
    {
      "id": "u03",
      "title": "调度：指标与基本策略",
      "concepts": ["sched-metrics", "fifo-sjf-stcf", "round-robin"],
      "exercises": [
        "给定 5 个作业的到达时间与运行时间，手算 FIFO、SJF、STCF、RR（时间片 2）的平均周转与响应时间",
        "用 OSTEP 的 scheduler.py 验证上题的手算结果"
      ],
      "exit_criteria": [
        "不看资料定义周转时间与响应时间，并指出两者冲突的场景",
        "对给定作业集手算四种策略的平均周转时间并排序",
        "解释 RR 时间片过小与过大的代价各是什么"
      ]
    },
    {
      "id": "u04",
      "title": "不知道运行时间怎么办：MLFQ",
      "concepts": ["mlfq"],
      "exercises": [
        "用 mlfq.py 构造一个让长作业饿死的输入，再说明优先级提升（boost）如何修复",
        "写一页纸说明 MLFQ 五条规则分别解决什么问题"
      ],
      "exit_criteria": [
        "不看资料写出 MLFQ 的五条规则",
        "解释为什么需要周期性提升优先级，以及为什么要按总配额而不是单次运行计时降级",
        "给一个交互型加一个计算型作业的例子，画出两者在各队列间的移动"
      ]
    }
  ],
  "notes": "骨架依据 OSTEP（Arpaci-Dusseau，在线版 v1.10）第 4 章进程、第 5 章进程 API、第 6 章受限直接执行、第 7 章调度导论、第 8 章 MLFQ；第 9 章彩票调度与第 10 章多处理器调度列为分支。multiprocessor-sched 标为 uncertain：是否纳入取决于学习者后续目标。每单元按每周 8 小时估计一到两周。"
}
```

## 反例（评审员会标为 blocking 或 major）

- 退出标准写成「理解进程的概念」「掌握调度算法」：不可检验。应改为「写出」「画出」「手算」「解释为什么」。
- 一个单元塞 12 个概念，或第一个单元是「操作系统概述」这类抽象导论：第一天无事可做。
- 概念过粗（「调度」）或过细（「RR 的时间片为 2 的情形」）：前者一段话讲不清，后者不值一题。
- 把「相关」当前置：例如让 round-robin 依赖 process-api。前置只写不懂它就读不懂这一节的依赖。
- notes 不写依据教材，或写「综合多种资料」：无法核对结构是否公认。
- 重规划时改了已有概念的 id，或推翻已完成单元：黑板上的掌握度会丢失关联。
