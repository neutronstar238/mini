#include <stdio.h>
int main(void) {
  int a[] = {2,1,4,3}, next[4] = {-1,-1,-1,-1}, st[4], top=0;
  for(int i=0;i<4;++i){while(top&&a[st[top-1]]<a[i]){next[st[--top]]=a[i];}st[top++]=i;}
  printf("%d %d %d %d\n", next[0],next[1],next[2],next[3]);
  return 0;
}
