#include <stdio.h>
#include <limits.h>
int main(void) {
  int g[4][4] = {{0,1,4,0},{1,0,2,5},{4,2,0,1},{0,5,1,0}};
  int best[4] = {0, INT_MAX, INT_MAX, INT_MAX}, used[4] = {0}, total = 0;
  for (int step=0;step<4;++step) { int u=-1; for(int i=0;i<4;++i) if(!used[i]&&(u<0||best[i]<best[u]))u=i; used[u]=1; total+=best[u]==INT_MAX?0:best[u]; for(int v=0;v<4;++v)if(g[u][v]&&!used[v]&&g[u][v]<best[v])best[v]=g[u][v]; }
  printf("%d\n", total);
  return 0;
}
