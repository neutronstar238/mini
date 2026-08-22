#include <stdint.h>
#include <stdio.h>
int main(void) {
  uint32_t value = UINT32_C(0x0f0f);
  printf("%u:%u\n", value & UINT32_C(0xff), value ^ UINT32_C(0xffff));
  return 0;
}
