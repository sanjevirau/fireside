## Soak resource measurements

Swap activity is reported, not gated. No performance winner is required. Missing stacks are not measured, never zero.

| Measurement | Official | Fireside |
| --- | ---: | ---: |
| Swap-in pages | 4623 | 876 |
| Swap-out pages | 0 | 0 |
| Residual swap at window start (bytes) | 2697363456 | 1876930560 |
| Residual swap at window end (bytes) | 2693443584 | 1869516800 |

Top processes ranked independently by per-PID maximum sampled PSS (not simultaneous totals):

| Rank | Official process | Peak PSS (bytes) | Fireside process | Peak PSS (bytes) |
| ---: | --- | ---: | --- | ---: |
| 1 | next-server (v1 (PID 763175) | 7001562112 | next-server (v1 (PID 766378) | 8300575744 |
| 2 | java (PID 763298) | 534455296 | TwodartNet (PID 766834) | 445403136 |
| 3 | TwodartNet (PID 763653) | 455887872 | dotnet (PID 766634) | 261937152 |
| 4 | java (PID 763501) | 163064832 | MainThread (PID 767303) | 160065536 |
| 5 | MainThread (PID 764689) | 161393664 | MainThread (PID 767429) | 157992960 |
| 6 | MainThread (PID 765472) | 157765632 | MainThread (PID 767423) | 157809664 |
| 7 | MainThread (PID 765478) | 157701120 | MainThread (PID 766785) | 93155328 |
| 8 | dotnet (PID 763449) | 140082176 | MainThread (PID 766970) | 90258432 |
| 9 | MainThread (PID 763115) | 119623680 | MainThread (PID 766977) | 84915200 |
| 10 | java (PID 763551) | 112303104 | MainThread (PID 766983) | 84353024 |

