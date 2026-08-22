#include <stdio.h>
static void visit(int u, int n, int g[6][6], int *seen) {
  seen[u] = 1;
  for (int v = 0; v < n; ++v) if (g[u][v] && !seen[v]) visit(v, n, g, seen);
}
int main(void) {
  int g[6][6] = {{0,1,0,0,0,0},{1,0,0,0,0,0},{0,0,0,1,0,0},{0,0,1,0,0,0},{0,0,0,0,0,1},{0,0,0,0,1,0}};
  int seen[6] = {0}, components = 0;
  for (int i = 0; i < 6; ++i) if (!seen[i]) { ++components; visit(i, 6, g, seen); }
  printf("%d\n", components);
  return 0;
}
