#include <stdio.h>
#include <stdlib.h>
int main(void) {
  int *v = calloc(2, sizeof(*v));
  if (!v) return 2;
  v[0] = 4; v[1] = 5;
  int *grown = realloc(v, 3 * sizeof(*v));
  if (!grown) { free(v); return 2; }
  grown[2] = 6;
  printf("%d\n", grown[0] + grown[1] + grown[2]);
  free(grown);
  return 0;
}
