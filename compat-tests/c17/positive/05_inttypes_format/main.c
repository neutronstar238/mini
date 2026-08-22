#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
int main(void) {
  int64_t value = INT64_C(123456789);
  printf("%" PRId64 "\n", value);
  return 0;
}
