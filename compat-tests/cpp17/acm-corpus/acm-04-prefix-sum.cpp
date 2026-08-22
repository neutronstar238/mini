#include <bits/stdc++.h>
using namespace std;
int main(){int n,l,r;cin>>n>>l>>r;vector<int>p(n+1);for(int i=1,x;i<=n;i++){cin>>x;p[i]=p[i-1]+x;}cout<<p[r]-p[l-1]<<"\n";}
