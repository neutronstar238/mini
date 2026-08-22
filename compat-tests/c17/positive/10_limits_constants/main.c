#include <limits.h>
#include <stdio.h>
int main(void) {
  printf("%d:%d:%u\n", CHAR_BIT, INT_MAX == 2147483647, (unsigned)UINT_MAX);
  return 0;
}
