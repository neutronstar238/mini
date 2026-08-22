#include <stdio.h>
int main(void) {
  long double x = 1.25L + 2.75L;
  printf("%d\n", (int)(x + 0.5L));
  return 0;
}
