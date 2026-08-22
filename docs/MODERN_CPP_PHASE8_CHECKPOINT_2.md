# MODERN_CPP_PHASE8_CHECKPOINT_2

Evidence Fix:
PASS

runtimeAssetHash algorithm:
v1 legacy identity = SHA-256(final runtime-manifest.json raw bytes read from disk), with no manifest hash field, canonicalization, or self-reference. v2 runtime identity = SHA-256(UTF-8 canonical JSON of contractVersion, engineRuntimeId, target, peeled source pins, profile flags, execution protocol version, and ordered asset file/url/bytes/SHA-256); mutable and hash fields are excluded. The v2 canonical runtimeAssetHash is 8abec83e8375d5bd985f9c6fef62b2a3b3799bc7be52a89133c2689a19908419.

manifestFileSha256:
v1 25433ade343cb3e2e3a3255c5a26ffc600b659d26d296749c33ac34d1afaff3c; v2 876a024d70ffbbc22e0a0a0eed0597979317df0533afecd476c544c40a594b46 (external evidence over final 9524-byte manifest)

LLVM Tag:
llvmorg-19.1.7

LLVM Tag Object SHA:
f34bba6980332ba9447397fc8bd8a0951b224747

LLVM Peeled Source Commit:
cd708029e0b2869e80abe31ddb175f7c35361f90

Build Reproducibility Set:
20 assets

Published Runtime Manifest Set:
18 assets

Engine Runtime ID:
cpp-modern-engine-v2

Engine changed:
YES (v1 remains immutable and readable; v2 reuses its six live assets)

Optimization Policy:
-O2

Browser C17 flags:
clang -std=c17 -O2

Server C17 flags:
gcc-14 -std=c17 -O2 -Wall -Wextra -DONLINE_JUDGE <src> -lm -o <out>

Browser C++17 flags:
clang -std=c++17 -O2

Server C++17 flags:
g++-14 -std=c++17 -O2 -Wall -Wextra -DONLINE_JUDGE <src> -o <out>

--------------------------------

C17

Positive:
36/36

Negative CE:
15/15

Warning-No-CE:
10/10

ACM:
30/30

Compatibility:
91/91

Correctness:
66/66

E2E:
10/10

Timeout:
PASS

Network Isolation:
PASS

Status:
BETA

--------------------------------

C++17

Positive:
35/35

Negative CE:
15/15

Warning-No-CE:
10/10

ACM:
45/45

bits:
PASS

PCH:
DISABLED

PCH Neutrality:
N/A

Header Guard:
ENABLED + PASS

Compatibility:
105/105

Correctness:
80/80

E2E:
11/11

Timeout:
PASS

Network Isolation:
PASS

Status:
BETA

--------------------------------

Runtime:

Raw Asset Bytes:
105192857 (six immutable v1 live assets reused by v2)

Cold Start:
1982.2 ms (C++17 cold run; sum of recorded init/compile/link/instantiate/execute timings)

Cached Cold:
2312.6 ms (new page/compiler worker with runtime assets cached)

Compiler Init:
C17 201 ms; C++17 181 ms

bits compile:
1236 ms cold; 0 ms warm cache hit

Artifact Cache:
PASS

Reproducible Build:
PASS

ENGINEERING_REDISTRIBUTION_READY:
true

LEGAL_REVIEW_REQUIRED:
true

REDISTRIBUTABLE:
false

--------------------------------

Frozen Regression:

C11:
PASS

C++11:
PASS

Python:
PASS

Java21 BETA_FROZEN:
PASS

Blocking Failures:
[]
