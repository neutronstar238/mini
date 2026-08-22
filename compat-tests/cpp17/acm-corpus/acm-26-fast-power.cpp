#include <bits/stdc++.h>
using namespace std;
long long pw(long long a,long long n){long long r=1;for(;n;n>>=1,a=a*a%1000)if(n&1)r=r*a%1000;return r;}
int main(){cout<<pw(3,5)<<"\n";}
