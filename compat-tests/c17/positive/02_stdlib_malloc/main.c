#include <stdio.h>
#include <stdlib.h>
int main(void) {
  int *v = malloc(4 * sizeof(*v));
  if (!v) return 2;
  for (int i = 0; i < 4; ++i) v[i] = i + 1;
  int sum = 0;
  for (int i = 0; i < 4; ++i) sum += v[i];
  free(v);
  printf("%d\n", sum);
  return 0;
}
