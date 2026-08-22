#include <bits/stdc++.h>
using namespace std;
int main(){int b[6]{};auto add=[&](int i,int x){for(;i<=5;i+=i&-i)b[i]+=x;};auto sum=[&](int i){int s=0;for(;i;i-=i&-i)s+=b[i];return s;};for(int i=1;i<=5;i++)add(i,i);cout<<sum(4)-sum(1)<<"\n";}
