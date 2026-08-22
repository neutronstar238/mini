#include <stdio.h>
int main(void) {
    int value = 1;
    {
        int value = 2;
        printf("%d\n", value);
    }
    return 0;
}
