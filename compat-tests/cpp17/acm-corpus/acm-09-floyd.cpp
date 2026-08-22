#include <bits/stdc++.h>
using namespace std;
int main(){const int I=1e9;int d[3][3]={{0,4,10},{I,0,3},{I,I,0}};for(int k=0;k<3;k++)for(int i=0;i<3;i++)for(int j=0;j<3;j++)d[i][j]=min(d[i][j],d[i][k]+d[k][j]);cout<<d[0][2]<<"\n";}
