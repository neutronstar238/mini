#include <stdio.h>
static int identity(int value, int unused_parameter) {
    return value;
}
int main(void) {
    printf("%d\n", identity(7, 9));
    return 0;
}
