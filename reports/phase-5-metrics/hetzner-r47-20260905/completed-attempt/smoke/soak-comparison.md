## Soak resource measurements

Swap activity is reported, not gated. No performance winner is required. Missing stacks are not measured, never zero.

| Measurement | Official | Fireside |
| --- | ---: | ---: |
| Swap-in pages | 0 | 0 |
| Swap-out pages | 0 | 0 |
| Residual swap at window start (bytes) | 0 | 0 |
| Residual swap at window end (bytes) | 0 | 0 |

Top processes ranked independently by per-PID maximum sampled PSS (not simultaneous totals):

| Rank | Official process | Peak PSS (bytes) | Fireside process | Peak PSS (bytes) |
| ---: | --- | ---: | --- | ---: |
| 1 | next-server (v1 (PID 58170) | 8010834944 | next-server (v1 (PID 61112) | 8779788288 |
| 2 | java (PID 58279) | 709171200 | dotnet (PID 61365) | 293428224 |
| 3 | MainThread (PID 58111) | 347610112 | TwodartNet (PID 61544) | 223916032 |
| 4 | dotnet (PID 58440) | 340029440 | MainThread (PID 61227) | 185476096 |
| 5 | TwodartNet (PID 58633) | 224036864 | java (PID 61150) | 167844864 |
| 6 | java (PID 58475) | 212753408 | MainThread (PID 61623) | 161402880 |
| 7 | MainThread (PID 58907) | 161392640 | MainThread (PID 61999) | 160542720 |
| 8 | MainThread (PID 59716) | 160963584 | MainThread (PID 62102) | 158693376 |
| 9 | MainThread (PID 58921) | 158054400 | MainThread (PID 61637) | 157719552 |
| 10 | MainThread (PID 60354) | 158000128 | MainThread (PID 61629) | 157300736 |

