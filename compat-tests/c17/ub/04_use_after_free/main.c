#include <stdlib.h>
int main(void) {
    int *pointer = malloc(sizeof(*pointer));
    if (!pointer)
        return 0;
    *pointer = 3;
    free(pointer);
    return *pointer;
}
