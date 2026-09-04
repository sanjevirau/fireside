## Soak resource measurements

Swap activity is reported, not gated. No performance winner is required. Missing stacks are not measured, never zero.

| Measurement | Official | Fireside |
| --- | ---: | ---: |
| Swap-in pages | 792 | 4719 |
| Swap-out pages | 0 | 0 |
| Residual swap at window start (bytes) | 1052241920 | 756506624 |
| Residual swap at window end (bytes) | 1051148288 | 751812608 |

Top processes ranked independently by per-PID maximum sampled PSS (not simultaneous totals):

| Rank | Official process | Peak PSS (bytes) | Fireside process | Peak PSS (bytes) |
| ---: | --- | ---: | --- | ---: |
| 1 | next-server (v1 (PID 539976) | 7915035648 | next-server (v1 (PID 543172) | 8683710464 |
| 2 | java (PID 540090) | 642296832 | TwodartNet (PID 543590) | 452927488 |
| 3 | TwodartNet (PID 540442) | 435430400 | dotnet (PID 543395) | 376428544 |
| 4 | dotnet (PID 540234) | 265359360 | MainThread (PID 543990) | 160232448 |
| 5 | java (PID 540293) | 206983168 | MainThread (PID 544091) | 157273088 |
| 6 | MainThread (PID 541435) | 161403904 | MainThread (PID 544085) | 157139968 |
| 7 | MainThread (PID 542248) | 157672448 | java (PID 543123) | 108597248 |
| 8 | MainThread (PID 542247) | 156576768 | dotnet (PID 543152) | 107846656 |
| 9 | java (PID 540344) | 133204992 | MainThread (PID 543263) | 98703360 |
| 10 | MainThread (PID 539911) | 122208256 | MainThread (PID 543535) | 93197312 |

