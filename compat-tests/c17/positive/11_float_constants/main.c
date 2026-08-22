#include <float.h>
#include <stdio.h>
int main(void) {
  printf("%d:%d:%d\n", FLT_RADIX, FLT_MANT_DIG, DBL_MANT_DIG);
  return 0;
}
