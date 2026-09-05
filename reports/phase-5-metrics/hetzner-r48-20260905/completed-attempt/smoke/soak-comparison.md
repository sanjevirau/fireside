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
| 1 | next-server (v1 (PID 72803) | 7972720640 | next-server (v1 (PID 75732) | 8690911232 |
| 2 | java (PID 72911) | 717599744 | dotnet (PID 75978) | 366742528 |
| 3 | dotnet (PID 73075) | 365612032 | TwodartNet (PID 76069) | 227492864 |
| 4 | MainThread (PID 72739) | 346977280 | java (PID 75772) | 199067648 |
| 5 | TwodartNet (PID 73267) | 225586176 | MainThread (PID 76698) | 161542144 |
| 6 | java (PID 73114) | 185600000 | MainThread (PID 76798) | 158174208 |
| 7 | MainThread (PID 73552) | 161244160 | MainThread (PID 76792) | 157989888 |
| 8 | MainThread (PID 74331) | 160625664 | MainThread (PID 76247) | 128548864 |
| 9 | MainThread (PID 73532) | 158119936 | dotnet (PID 75742) | 123560960 |
| 10 | MainThread (PID 73542) | 157698048 | MainThread (PID 75852) | 98196480 |

