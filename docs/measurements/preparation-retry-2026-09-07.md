# Bounded preparation retry

The owned V8 creation trace contains 43 preparation events. It measured:

| Phase | Calls | Total duration |
| --- | ---: | ---: |
| Box create | 1 | 455.5 ms |
| Box GET | 31 (29 not ready) | 580.3 ms |
| Environment write | 2 | 186.7 ms |
| Service configuration/start | 2 | 6,197.1 ms |
| Private preview host command | 2 | 2,349.2 ms |
| Agent health | 2 (first failed) | 1,896.2 ms |
| Ready checkpoint | 1 | 8.3 ms |

After the first health failure, the second environment write, service command and host command
spent another **1,607.8 ms** before a successful 42.9 ms health response. That is measured repeated
work; it does not establish that the endpoint would already have succeeded immediately after the
first failure. The first provider readiness interval remains outside this optimization.

Lifecycle now gives a freshly prepared endpoint one further health request after 250 ms, within
the existing independent Companion job. The request retains its two-second timeout; there must be
budget for both the delay and request inside the five-minute preparation deadline. Leader and
current machine authority are checked again after the delay. A second failure clears the endpoint
and permits the existing prepare/repair path on the next pass. A failed reused warm endpoint skips
this retry and enters repair immediately. No endpoint cache or cross-loop state is added.

Tests cover transient readiness with only one preparation, persistent failure followed by repair,
invalid warm endpoint invalidation, leader loss, revocation and deadline exhaustion. Existing
independent-job tests verify that a stalled Companion cannot block another warm chat.

The preview transport exchanges `_token` for cookies on redirects and currently starts each
request with an empty cookie map. This can add an HTTP round trip, but the creation trace does not
separate redirects from final responses. No specific cookie-handshake duration, cache benefit or
provider-cold-start reduction is claimed. Cookie lifetime/revocation handling is unchanged.

The V8 physical-storage repair separately reduced one measured archive/wake preparation from
25.603 seconds on a previous run to 11.452 seconds. Different runs are not a controlled comparison;
that observation must not be attributed to this health retry, which had not run yet.
