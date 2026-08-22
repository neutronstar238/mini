#include <bits/stdc++.h>
using namespace std;
int main(){vector<bool>p(21,1);p[0]=p[1]=0;for(int i=2;i*i<=20;i++)if(p[i])for(int j=i*i;j<=20;j+=i)p[j]=0;cout<<count(p.begin(),p.end(),true)<<"\n";}
