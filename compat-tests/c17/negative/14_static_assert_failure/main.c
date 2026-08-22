#include <stddef.h>
int main(void) {
    int values[2] = {1, 2};
    _Static_assert(sizeof(values) == 12, "intentional C17 assertion failure");
    return values[0];
}
