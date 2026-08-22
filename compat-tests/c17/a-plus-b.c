#include <stdio.h>

int main(void) {
    long long a = 0;
    long long b = 0;
    if (scanf("%lld%lld", &a, &b) != 2) return 2;
    printf("%lld\n", a + b);
    return 0;
}
