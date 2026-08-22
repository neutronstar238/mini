#include <stdio.h>
#include <string.h>
int main(void) {
  const char *a="ABCBDAB",*b="BDCABA";int n=(int)strlen(a),m=(int)strlen(b),dp[16][16]={{0}};
  for(int i=1;i<=n;++i)for(int j=1;j<=m;++j)dp[i][j]=a[i-1]==b[j-1]?dp[i-1][j-1]+1:(dp[i-1][j]>dp[i][j-1]?dp[i-1][j]:dp[i][j-1]);
  printf("%d\n",dp[n][m]);
  return 0;
}
