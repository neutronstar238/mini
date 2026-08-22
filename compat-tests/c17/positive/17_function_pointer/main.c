#include <stdio.h>
static int twice(int x) { return x * 2; }
int main(void) {
  int (*operation)(int) = twice;
  printf("%d\n", operation(21));
  return 0;
}
