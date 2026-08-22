#include <bits/stdc++.h>
using namespace std;
int main(){string a="abcde",b="ace";int d[6][4]{};for(int i=1;i<=5;i++)for(int j=1;j<=3;j++)d[i][j]=a[i-1]==b[j-1]?d[i-1][j-1]+1:max(d[i-1][j],d[i][j-1]);cout<<d[5][3]<<"\n";}
