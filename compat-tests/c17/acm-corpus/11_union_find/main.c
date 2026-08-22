#include <stdio.h>
static int find_root(int *p, int x) { return p[x] == x ? x : (p[x] = find_root(p, p[x])); }
static void unite(int *p, int a, int b) { a = find_root(p, a); b = find_root(p, b); if (a != b) p[b] = a; }
int main(void) {
  int p[5] = {0,1,2,3,4}; unite(p, 0, 1); unite(p, 1, 2); unite(p, 3, 4);
  printf("%d:%d\n", find_root(p, 0) == find_root(p, 2), find_root(p, 0) == find_root(p, 4));
  return 0;
}
