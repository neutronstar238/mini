#include <stdio.h>
#include <stdint.h>
_Static_assert(sizeof(uint32_t) == 4, "uint32_t must be 32 bits");
int main(void) {
  printf("%zu\n", sizeof(uint32_t));
  return 0;
}
