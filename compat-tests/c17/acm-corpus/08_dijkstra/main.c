#include <stdio.h>
#include <limits.h>
int main(void) {
  int g[4][4] = {{0,4,1,0},{4,0,2,5},{1,2,0,8},{0,5,8,0}};
  int d[4] = {0, INT_MAX, INT_MAX, INT_MAX}, used[4] = {0};
  for (int step = 0; step < 4; ++step) {
    int u = -1;
    for (int i = 0; i < 4; ++i) if (!used[i] && (u < 0 || d[i] < d[u])) u = i;
    used[u] = 1;
    for (int v = 0; v < 4; ++v) if (g[u][v] && d[u] <= INT_MAX - g[u][v] && d[u] + g[u][v] < d[v]) d[v] = d[u] + g[u][v];
  }
  printf("%d\n", d[3]);
  return 0;
}
