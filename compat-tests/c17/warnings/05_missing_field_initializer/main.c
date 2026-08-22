#include <stdio.h>
struct Pair { int first; int second; };
int main(void) {
    struct Pair pair = {1};
    printf("%d\n", pair.first);
    return 0;
}
