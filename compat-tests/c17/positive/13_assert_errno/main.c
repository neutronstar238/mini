#include <assert.h>
#include <errno.h>
#include <stdio.h>
int main(void) {
  int value = 5;
  assert(value == 5);
  errno = 123;
  printf("%d\n", errno);
  return 0;
}
