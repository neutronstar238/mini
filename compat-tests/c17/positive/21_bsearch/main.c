#include <stdio.h>
#include <stdlib.h>
static int compare_ints(const void *a, const void *b) {
  int left = *(const int *)a, right = *(const int *)b;
  return (left > right) - (left < right);
}
int main(void) {
  int v[] = {1, 3, 5, 7};
  int needle = 5;
  int *found = bsearch(&needle, v, 4, sizeof(v[0]), compare_ints);
  printf("%d\n", found ? *found : -1);
  return 0;
}
