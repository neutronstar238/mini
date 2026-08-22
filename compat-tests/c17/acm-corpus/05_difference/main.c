#include <stdio.h>
int main(void) {
  int a[] = {3, 7, 4, 9};
  int diff[4]; diff[0] = a[0];
  for (int i = 1; i < 4; ++i) diff[i] = a[i] - a[i - 1];
  printf("%d %d %d %d\n", diff[0], diff[1], diff[2], diff[3]);
  return 0;
}
