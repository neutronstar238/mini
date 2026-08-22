#include <stdio.h>
#include <limits.h>
int main(void) {
  int g[4][4] = {{0,4,0,10},{0,0,-2,0},{0,0,0,3},{0,0,0,0}};
  int d[4] = {0, INT_MAX, INT_MAX, INT_MAX}, q[32], in[4] = {0}, h = 0, t = 0;
  q[t++] = 0; in[0] = 1;
  while (h < t) {
    int u = q[h++]; in[u] = 0;
    for (int v = 0; v < 4; ++v) if (g[u][v] && d[u] + g[u][v] < d[v]) {
      d[v] = d[u] + g[u][v]; if (!in[v]) { q[t++] = v; in[v] = 1; }
    }
  }
  printf("%d\n", d[3]);
  return 0;
}
