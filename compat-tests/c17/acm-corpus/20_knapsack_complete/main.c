#include <stdio.h>
int main(void) {
  int weight[]={2,3}, value[]={3,4}, dp[8]={0};
  for(int i=0;i<2;++i)for(int c=weight[i];c<=7;++c)if(dp[c-weight[i]]+value[i]>dp[c])dp[c]=dp[c-weight[i]]+value[i];
  printf("%d\n",dp[7]);
  return 0;
}
