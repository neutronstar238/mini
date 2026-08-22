#include <stdio.h>
typedef struct { int u, v, w; } Edge;
static int root(int *p, int x) { return p[x] == x ? x : (p[x] = root(p, p[x])); }
int main(void) {
  Edge e[] = {{0,1,1},{1,2,2},{0,2,4},{2,3,1},{1,3,5}};
  int p[4] = {0,1,2,3}, total = 0, used = 0;
  for (int pass = 0; pass < 5; ++pass) for (int i = 0; i < 4; ++i) if (e[i].w > e[i+1].w) { Edge x=e[i]; e[i]=e[i+1]; e[i+1]=x; }
  for (int i = 0; i < 5 && used < 3; ++i) { int a=root(p,e[i].u), b=root(p,e[i].v); if(a!=b){p[a]=b;total+=e[i].w;++used;} }
  printf("%d\n", total);
  return 0;
}
