#include <stdio.h>
int main(void) {
  int a[]={10,9,2,5,3,7,101,18}, d[8],len=0;
  for(int i=0;i<8;++i){int lo=0,hi=len;while(lo<hi){int m=(lo+hi)/2;if(d[m]<a[i])lo=m+1;else hi=m;}d[lo]=a[i];if(lo==len)++len;}
  printf("%d\n",len);
  return 0;
}
