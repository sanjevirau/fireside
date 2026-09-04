## Soak resource measurements

Swap activity is reported, not gated. No performance winner is required. Missing stacks are not measured, never zero.

| Measurement | Official | Fireside |
| --- | ---: | ---: |
| Swap-in pages | 2326 | 245 |
| Swap-out pages | 0 | 0 |
| Residual swap at window start (bytes) | 1520148480 | 823730176 |
| Residual swap at window end (bytes) | 1423400960 | 822439936 |

Top processes ranked independently by per-PID maximum sampled PSS (not simultaneous totals):

| Rank | Official process | Peak PSS (bytes) | Fireside process | Peak PSS (bytes) |
| ---: | --- | ---: | --- | ---: |
| 1 | next-server (v1 (PID 685860) | 7774426112 | next-server (v1 (PID 688999) | 8744513536 |
| 2 | java (PID 685974) | 603467776 | TwodartNet (PID 689456) | 448440320 |
| 3 | TwodartNet (PID 686332) | 414047232 | dotnet (PID 689258) | 374849536 |
| 4 | dotnet (PID 686123) | 241602560 | MainThread (PID 689877) | 161217536 |
| 5 | MainThread (PID 685796) | 225976320 | MainThread (PID 690031) | 158049280 |
| 6 | MainThread (PID 687342) | 160082944 | MainThread (PID 690032) | 157735936 |
| 7 | MainThread (PID 688081) | 158332928 | java (PID 688998) | 139408384 |
| 8 | MainThread (PID 688087) | 157768704 | dotnet (PID 689000) | 119405568 |
| 9 | java (PID 686181) | 154456064 | MainThread (PID 689131) | 96827392 |
| 10 | java (PID 686231) | 133095424 | MainThread (PID 689402) | 92740608 |

