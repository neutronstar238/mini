#include <stdio.h>
int main(void) {
    int value = 0;
    switch (1) {
        case 1:
            value = 1;
        case 2:
            value += 2;
            break;
        default:
            break;
    }
    printf("%d\n", value);
    return 0;
}
