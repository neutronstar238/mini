#include <stdio.h>
#include <stdlib.h>
static int compare_ints(const void *a, const void *b) {
  int left = *(const int *)a, right = *(const int *)b;
  return (left > right) - (left < right);
}
int main(void) {
  int v[] = {4, 1, 3, 2};
  qsort(v, 4, sizeof(v[0]), compare_ints);
  for (size_t i = 0; i < 4; ++i) printf("%d%s", v[i], i == 3 ? "\n" : " ");
  return 0;
}
