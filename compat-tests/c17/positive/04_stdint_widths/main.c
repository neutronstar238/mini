#include <stdint.h>
#include <stdio.h>
#include <inttypes.h>
int main(void) {
  int32_t a = INT32_C(7);
  uint64_t b = UINT64_C(9);
  printf("%" PRId32 ":%" PRIu64 "\n", a, b);
  return 0;
}
