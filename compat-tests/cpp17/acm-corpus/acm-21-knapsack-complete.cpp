#include <bits/stdc++.h>
using namespace std;
int main(){int d[8]={};for(int j=2;j<=7;j++)d[j]=max(d[j],d[j-2]+3);cout<<d[7]<<"\n";}
