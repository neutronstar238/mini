#include <bits/stdc++.h>
using namespace std;
int main(){int w[3]={2,3,4},v[3]={3,4,5},d[7]={};for(int i=0;i<3;i++)for(int j=6;j>=w[i];j--)d[j]=max(d[j],d[j-w[i]]+v[i]);cout<<d[6]<<"\n";}
