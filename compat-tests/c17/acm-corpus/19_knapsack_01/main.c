#include <stdio.h>
int main(void) {
  int weight[]={2,3,4}, value[]={3,4,5}, dp[8]={0};
  for(int i=0;i<3;++i)for(int c=7;c>=weight[i];--c)if(dp[c-weight[i]]+value[i]>dp[c])dp[c]=dp[c-weight[i]]+value[i];
  printf("%d\n",dp[7]);
  return 0;
}
