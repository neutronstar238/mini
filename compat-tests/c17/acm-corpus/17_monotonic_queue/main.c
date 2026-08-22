#include <stdio.h>
int main(void) {
  int a[] = {1,3,-1,-3,5,3,6,7}, dq[8], h=0,t=0;
  for(int i=0;i<8;++i){while(h<t&&dq[h]<=i-3)++h;while(h<t&&a[dq[t-1]]<=a[i])--t;dq[t++]=i;if(i>=2)printf("%d%s",a[dq[h]],i==7?"\n":" ");}
  return 0;
}
