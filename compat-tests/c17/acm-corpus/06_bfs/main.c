#include <stdio.h>
int main(void) {
  int graph[5][5] = {{0,1,1,0,0},{1,0,0,1,0},{1,0,0,0,1},{0,1,0,0,1},{0,0,1,1,0}};
  int q[5], dist[5] = {-1,-1,-1,-1,-1}, head = 0, tail = 0;
  q[tail++] = 0; dist[0] = 0;
  while (head < tail) {
    int u = q[head++];
    for (int v = 0; v < 5; ++v) if (graph[u][v] && dist[v] < 0) {
      dist[v] = dist[u] + 1; q[tail++] = v;
    }
  }
  printf("%d\n", dist[4]);
  return 0;
}
