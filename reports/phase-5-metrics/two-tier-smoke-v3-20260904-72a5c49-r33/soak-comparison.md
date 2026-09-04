## Soak resource measurements

Swap activity is reported, not gated. No performance winner is required. Missing stacks are not measured, never zero.

| Measurement | Official | Fireside |
| --- | ---: | ---: |
| Swap-in pages | 163 | 3262 |
| Swap-out pages | 0 | 0 |
| Residual swap at window start (bytes) | 762527744 | 821473280 |
| Residual swap at window end (bytes) | 762458112 | 819171328 |

Top processes ranked independently by per-PID maximum sampled PSS (not simultaneous totals):

| Rank | Official process | Peak PSS (bytes) | Fireside process | Peak PSS (bytes) |
| ---: | --- | ---: | --- | ---: |
| 1 | next-server (v1 (PID 552223) | 8103632896 | next-server (v1 (PID 555339) | 8637180928 |
| 2 | java (PID 552342) | 644016128 | TwodartNet (PID 555773) | 459423744 |
| 3 | TwodartNet (PID 552697) | 424811520 | dotnet (PID 555586) | 374777856 |
| 4 | MainThread (PID 552163) | 336295936 | MainThread (PID 556275) | 159773696 |
| 5 | dotnet (PID 552487) | 301026304 | MainThread (PID 556378) | 158238720 |
| 6 | java (PID 552541) | 181866496 | MainThread (PID 556384) | 157438976 |
| 7 | MainThread (PID 553682) | 159889408 | dotnet (PID 555346) | 105810944 |
| 8 | MainThread (PID 554425) | 158040064 | MainThread (PID 555455) | 97180672 |
| 9 | MainThread (PID 554419) | 157761536 | MainThread (PID 555722) | 91460608 |
| 10 | java (PID 552592) | 121013248 | MainThread (PID 555888) | 90882048 |

