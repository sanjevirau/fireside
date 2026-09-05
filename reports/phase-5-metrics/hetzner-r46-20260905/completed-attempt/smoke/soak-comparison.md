## Soak resource measurements

Swap activity is reported, not gated. No performance winner is required. Missing stacks are not measured, never zero.

| Measurement | Official | Fireside |
| --- | ---: | ---: |
| Swap-in pages | 0 | 0 |
| Swap-out pages | 0 | 0 |
| Residual swap at window start (bytes) | 0 | 524288 |
| Residual swap at window end (bytes) | 0 | 524288 |

Top processes ranked independently by per-PID maximum sampled PSS (not simultaneous totals):

| Rank | Official process | Peak PSS (bytes) | Fireside process | Peak PSS (bytes) |
| ---: | --- | ---: | --- | ---: |
| 1 | next-server (v1 (PID 24274) | 13438665728 | next-server (v1 (PID 27762) | 13161745408 |
| 2 | java (PID 24402) | 692586496 | MainThread (PID 27877) | 329415680 |
| 3 | MainThread (PID 24488) | 409564160 | dotnet (PID 28313) | 294890496 |
| 4 | MainThread (PID 24217) | 363291648 | MainThread (PID 27955) | 249484288 |
| 5 | MainThread (PID 24556) | 319319040 | TwodartNet (PID 28534) | 222384128 |
| 6 | VBCSCompiler (PID 25059) | 295137280 | java (PID 27783) | 198720512 |
| 7 | dotnet (PID 24986) | 283307008 | MainThread (PID 28099) | 198373376 |
| 8 | java (PID 24801) | 237135872 | MainThread (PID 28046) | 190067712 |
| 9 | TwodartNet (PID 25343) | 223204352 | MainThread (PID 28070) | 186858496 |
| 10 | MainThread (PID 24495) | 208650240 | MainThread (PID 27866) | 182108160 |

